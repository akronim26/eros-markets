# Kuru × Eros TestUSDC compatibility spike (local fork)

- Date: 2026-10-13. Source revision: `df8b01c` (`feat/pricefeed`), plus uncommitted native-market files.
- Environment: **local anvil fork** of Monad testnet (chain 10143), forked at block 70491754. Kuru's real deployed bytecode was executed, but **no public transactions were sent**. These are fork receipts, not public receipts.
- Script: [`scripts/native-market/kuru-fork-spike.sh`](../../../scripts/native-market/kuru-fork-spike.sh). Output: [`run.log`](run.log), exit 0.
- Tasks: NM-B01–NM-B04 evidence (fork). NM-B06 still needs a short public testnet smoke run.

## Result: PASS — Kuru accepts Eros TestUSDC as quote

| Check | Result |
| --- | --- |
| Kuru on 10143 (public RPC reads) | Router `0x7EFb…4630` (impl `0xaaa0…e1ed`), MarginAccount `0xd029…CE02`, both ERC-1967 proxies with code |
| TestUSDC `0x82C7…c1DB` | "Eros Test USDC" / tUSDC, 6 decimals, plain Solady ERC-20, open faucet (`mint` ≤ 100,000e6 per call) |
| `Router.deployProxy` permissions | Permissionless: simulated from an arbitrary EOA via public-RPC `eth_call`, and executed on the fork. No token whitelist. Zero fees (0/0 bps) also simulated OK |
| Market params read back | pricePrecision 1000, sizePrecision 1000, base/quote decimals 6/6, tick 1, minSize 1, maxSize 1e9, taker 30 / maker 10 bps |
| MarginAccount deposit of tUSDC and a 6-decimal ERC-20 | OK |
| Post-only bid 0.400 × 100 and ask 0.600 × 100 | OK; locks 40 tUSDC and 100 YES. `bestBidAsk` = (4e17, 6e17) |
| Market buy 30 tUSDC (margin) | Filled 50 YES at 0.600; taker received 49.85 (0.3% taker fee) |
| Market sell 10 YES (margin) | Filled at 0.400; taker received 3.988 tUSDC (0.3% fee) |
| `batchCancelOrders` | OK; book empty afterwards |
| Withdraw all margin to wallets | OK. Wallet totals: YES 1,999.9 / 2,000, tUSDC 1,999.992 / 2,000. The difference equals Kuru protocol fees held in MarginAccount |

## Facts that matter for the build

- **Units line up with Eros exactly.** sizePrecision 1000 means 1 size unit = 0.001 claim = **1 Eros lot**. pricePrecision 1000 with tick 1 means 1 price unit = 0.001 = **1 Eros tick**.
- **`bestBidAsk()` returns WAD (1e18) prices.** On an empty book it returns `(type(uint256).max, 0)`. The observer must treat that sentinel as an empty book, not as a price.
- **`placeAndExecuteMarketBuy` takes a quote amount** in pricePrecision units: 30000 = 30 tUSDC. **`placeAndExecuteMarketSell` takes a base size** in sizePrecision units.
- **Funds sit in Kuru's MarginAccount.** Before redeeming, cancel orders and `withdraw(amount, token)` back to the wallet.
- **The public Monad RPC limits `eth_getLogs` to a 100-block range.** The observer and maker should use pinned-block `eth_call` reads (`getL2Book`, `bestBidAsk`) and short log ranges.
- **Fees are configurable per market.** For the demo, choose 0/0 or keep 30/10 and show fee-aware previews.

## Not yet proven

- Public-testnet receipts (NM-B06). This needs a funded key and takes about 10 minutes; reuse the script with `R=<testnet RPC>` and real keys.
- `getL2Book()` byte layout (raw bytes captured only). Decode it during NM-F03/F04.
- Monad gas costs for each Kuru operation; the fork does not model Monad gas.
- Edge cases: FOK, `minAmountOut` reverts, insufficient balance (NM-B05, IF-TIME).
