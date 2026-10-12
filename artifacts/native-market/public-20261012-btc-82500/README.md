# Native market on Monad testnet: BTC/USD > $82,500 (public)

- Date: 2026-10-12 ~22:40–23:00 UTC. Chain: **Monad testnet 10143**. Source revision: `feat/native-market` at `cdd3645` (plus the keeper loop committed with this record).
- **Event:** "Will BTC/USD close above $82,500 on Kraken at 23:00 UTC on 14 October 2026?"
  - T = 1792018800 (2026-10-14T23:00:00Z).
  - Rules text: [params.json](params.json); `erosRulesHash` `0x0cdf…ed38`.
  - BTC was about $82,500 when listed (Kraken 82,507; Bitstamp 82,509; CoinGecko 82,499; Binance 82,613).
- **Labels:**
  - test collateral (tUSDC);
  - 1×, funding off;
  - team-controlled spot and perp liquidity (controlled activity, not independent demand);
  - one trusted INDEX signer;
  - sandbox adjudication.

| Item | Address |
| --- | --- |
| MarketRegistry (existing) | `0x780E73dDc65113F8C9C506daa25A0404Ed9f3E33` |
| marketId | `0x0f6b5f9fae4a00d5612f6a06f055f67d15418cf50329b925aefa52910053921a` |
| NativeOutcomeVault | `0x17f459C7D7164f619f851bCf174A58AD4DdAE06a` |
| YES / NO tokens | `0xf0499e5DaB56071587B35E0e54B31507DB1D0dE9` / `0x5c45ac6Ccf5A6B83493806405658639De22bfFcF` |
| Kuru YES/tUSDC book | `0x91e1473745FD5A80DE421C366581911aA35A30F9` |
| Kuru NO/tUSDC book | `0x6A40945a26906F5BE2b40BbD095BCBDdac647AAb` |
| Engine (RegistryBookRiskEngine) | `0xE7C13DAE7c5CEA0925886a917F3ce213C7C2D606` |
| INDEX source id / signer | `0x0ac25ed0…40d6` / `0x5aE3c3f1622c7360B032ADb135f51F97aD3d8Dd9` |
| INDEX rules hash | `0xe8f7bb1c386499fb04dab45f4c43daeee8639405adbeb056fc452bcded86ef75` ([rules.json](rules.json)) |

## Transactions (all status 1)

| Step | Tx / evidence |
| --- | --- |
| Deploy vault, YES/NO, 2 Kuru books (`DeployNativeMarket`) | [deploy-receipts.json](deploy-receipts.json) (3 txs) |
| `createMarket` + `bindMarket` (`ListNativeMarket`, `--gas-estimate-multiplier 105`; createMarket estimate 27.86M, under the 30M tx cap) | [list-receipts.json](list-receipts.json) |
| Timelock `propose(activateMarket)` | `0x002fb47c9d73429e89fd415ec4a6ca6e6ae75ab3bc94cc9d6dfed102ef79c76e` (block 70,520,231) |
| Timelock `execute` after 300 s → `active() == true` | `0xdac44204ac56085f53dd012a75f1c979925435d850824910dc8a287e405317ac` |
| Spot maker: split 500 sets, deposit, quote YES and NO 0.48/0.52 × 200 claims | 13 txs, e.g. split `0x08a8c0ba…99e4d` |
| Trader buys 50 YES for 26 tUSDC on Kuru (0 fees) | `0x2e7b20ab507f8d6cd367a3ac26603354f727844289d70d7482ec0c23864bfabe` |
| Native INDEX: first accepted observation (seq 1, mid 0.5, bid 0.48, ask 0.52) | `0xc61a02d458cdf1583961045eab466d06519dca222cc2170d63d27d285d82014c` ([publisher-first-rounds.json](publisher-first-rounds.json)); INDEX TWAP available = 0.5 after 60 s |
| Perp maker funds and quotes 0.490/0.510 × 150 claims | 5 txs |
| Keeper: `activatePricing()` after 8 sealed samples → `pricingMode = 1` | `0x00287f4d20e6e3b1391710d0ef42dcfb4a59274725e4d5db5c08b5b9ef88a560` |
| 1× perp fill: trader long 20 claims at 0.51 (cash 100 → 89.8; E1 109.8); maker short | `0x4b57f61b11bfa3be540ce448e05576a455c0ae45ced5dc95d67c8084e6369b8a` |
| Kuru withdraw: trader 10 tUSDC margin → wallet | `0xeb57f98cdfd9789af868a952883d85c88016a5d595931fd0036001822465b9b4` |

## Measured costs (102 gwei)

- `samplePerp` ≈ 478k gas, about **0.063 MON** per sample at 1.3×. The 7.3M figure was the keeper's maximum gas setting, not actual usage.
- `createMarket` used about 29.3M gas, the limit charged at 1.05×.

## Operations left running (local host)

- **Publisher:** `native-publish.js`, 30 s cadence, `finalized` reads → `tmp/native-public/publisher.log`.
- **Keeper loop:** `scripts/native-market/keeper-daemon.sh`, 90 s samples plus hourly rollover and perp re-quote → `tmp/native-public/keeper.log`.
- **Budget:** these are funded from the `NATIVE_*` keys in `secrets.md`. The keeper uses about 2.5 MON/h.

Settlement happens after T and is not shown here. The local real-stack proof is `oracle/test/integration/NativeSettlement.t.sol`.

## First hourly rollover (unattended)

At 23:00:21Z the keeper loop:
1. detected that `beginRollover` was open;
2. ran `beginRollover` → `rollPage` → `finishRollover`;
3. re-posted the perp maker's 0.490/0.510 quotes (`0x5ab3ba06…`, `0xdec2adc9…`).

Sampling resumed at 23:00:34Z with PERP and INDEX available and `pricingMode = 1`. The publisher had 25 observations accepted by 23:04Z. Keeper spend was 40 → 39.14 MON in about 10 minutes, including the rollover.

## Remaining lifecycle actions (public, 23:05–23:08Z)

| Action | Result | Tx |
| --- | --- | --- |
| Kuru cancel | Extra 1-claim YES bid (order 3) cancelled; live depth untouched | `0x1f2f54e1240281a214168c3db2d564aa80cf62aec527e712a03f0ea6f638b013` |
| NO trade | Trader bought 20 NO for 10.4 tUSDC (Kuru tUSDC 64 → 53.6) | `0xbc32f075aea4a041a7a1e6d9d7a5297f3fc653aa343da1d391e70ae52b444e16` |
| Merge | Withdrew 20 YES + 20 NO from Kuru, merged 20 sets; wallet tUSDC 810 → 830; vault sets 500 → 480 | `0x3bc40b15ee715051209f225d29c953ccbb9b2633dc6f95331ce912ad0d5c2e3f` |
| Perp close | Reduce-only sell of 20 at 0.49; cash 89.8 → 99.6, flat | `0x08ccd25345fa6aed5122fc8f09cb6b90b41e08353e39322bfb0c14f20f2fcb92` |
| Release + withdraw | 99.6 tUSDC back to the wallet (929.6) | `0xb2a3d4f2…a867`, `0x94ab18c5…ad5a` |
