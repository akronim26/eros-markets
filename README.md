<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/akronim26/eros-markets/main/docs/assets/eros-mark-on-dark.svg">
    <img src="https://raw.githubusercontent.com/akronim26/eros-markets/main/docs/assets/eros-mark-on-light.svg" alt="Eros Markets logo" width="104" height="104">
  </picture>
</p>

<h1 align="center">Eros Markets</h1>

<p align="center">Long or short real-world event outcomes. Trade on Monad.</p>

<p align="center">
  <a href="#key-features">Features</a> &middot;
  <a href="#architecture--user-flow">Architecture</a> &middot;
  <a href="#-quick-start">Quick start</a>
</p>

## Introduction

Eros Markets lets you trade real-world events with leverage on Monad. You go long or short on an event's YES price through an on-chain order book, and when the event resolves, your position settles against what actually happened.

Here's the problem we kept running into. A YES token pays 1 USDC if the event happens and nothing if it doesn't, so its price is basically the market's probability. Trading that with leverage works fine while the question is still open. But at resolution the price doesn't drift to 0 or 1, it jumps there in a single block. No liquidator can get in front of that, and a leveraged trader on the wrong side simply can't cover the loss.

So we built around two rules. First, leverage has to come down to `1x` before the jump. Second, whatever losses are still left have to be covered by a reserve that's funded up front. The order book, the margin engine, the reserve and the payouts all live on-chain.

We use **Polymarket as an outside price reference**. Trades don't go to Polymarket and we don't borrow its liquidity. Orders match on Eros, against Eros makers, backed by Eros collateral and reserves. Polymarket just helps us tell what a fair price looks like.

## Key Features

- **The order book is fully on-chain**: `999` price ticks from `0.001` to `0.999`, a small bitmap to find the best price fast, first-in-first-out queues at each price, and a hard cap on how much work one match can do.
- **Long or short, up to 5×**: that's the ceiling a market can be listed with. How much you can actually open depends on the price, the calibration, your collateral, the reserve and how close the market is to resolving.
- **The reserve covers both outcomes**: at every step we check that the reserve could pay out whether the event ends YES or NO. If both ends are covered, every INVALID price in between is covered too.
- **Margin that knows about the deadline**: margin grows as resolution gets closer and as the chance of a sudden jump goes up. Everything rounds against the trader. If the risk parameters are missing or out of date, the market falls back to 1x instead of guessing.
- **Leverage winds down on a fixed schedule**: 12.5 hours before the scheduled end, new positions must be fully backed. At 12 hours every account must be. In the last hour you can only reduce. Then trading stops. The full-backing check doesn't need a price, so it still works if the price feed goes quiet.
- **Liquidation tries the gentle options first**: we first try to match two accounts that both need closing, then sell into the book. Only if an account's equity has hit zero do we move the whole thing into the reserve. Thin liquidity on its own is never a reason to take someone's account.
- **Settlement doesn't get stuck**: the oracle's halt and settle calls do a fixed amount of work. Payouts are prepared in small batches afterwards, and each trader claims exactly once.

## Mathematical Foundation

### The EventPerp Model

#### Core Mathematical Concepts

**1. Event prices get more volatile near the end**

$$p_t=\mathbb E[Y\mid\mathcal F_t],\qquad \mathbb E\Big[\sum_k\Delta_k^2\ \Big|\ \mathcal F_t\Big]=p_t(1-p_t)$$

The price is the market's best guess of the outcome, and the total amount it still has to move doesn't shrink as time runs out. A month out, that movement is spread over a month. An hour out, it all has to happen in an hour. That's why a BTC perp can offer the same leverage forever and an event perp can't.

**2. Every account has two possible endings**

With `n` your position in lots and `c` your cash:

$$E_0=c,\qquad E_1=c+1000Q\,n,\qquad E(p)=c+1000\,n\,p_{Wad}$$

`E0` is what you're worth if the event ends NO, `E1` if it ends YES. If both are zero or above, you're fully backed. Checking this doesn't need a price at all.

**3. The reserve has to cover the worst losses on both sides**

Every long has a matching short, so all the money in the market is the reserve plus the traders' balances. Work it through and traders can only be paid more than the market holds if the reserve is smaller than their combined losses. So we check, separately for NO and for YES:

$$R_y\ \ge\ \bar D_y + B\qquad (y=0,1)$$

`R_y` is the reserve's value in outcome `y`, `D̄_y` is the traders' worst-case shortfall, and `B` is what's left in the funding budget. If both endings pass, any INVALID price between them passes too.

**4. The margin formula**

With the chance of an adverse jump `a_adv`, a 1% tolerance `ε`, a liquidation horizon `h` that grows with position size, and your worst-case loss per claim `w` (the price for a long, one minus the price for a short):

$$\epsilon'=\frac{\epsilon-a_{adv}}{1-a_{adv}},\quad k=\sqrt{\frac{1-\epsilon'}{\epsilon'}},\quad \sigma_h=\max\Big(\sqrt{\tfrac{q(1-q)h}{T-t}},\ \sigma_{realized},\ \sigma_{template}\Big)$$

$$MM=\min\big(|x|w,\ |x|(m_{side}+k\sigma_h+s)+\tfrac12\lambda x^2\big),\qquad IM=\min\big(|x|w,\ \max(\gamma MM,\ |x|w/L_{cap})\big)$$

Anything that makes margin bigger rounds up, and anything that makes it smaller rounds down. If the inputs stop making sense (the jump risk is too high, or a number rounds to zero), the engine just asks for full backing. It never divides by your position or your equity, so a zero position can't blow anything up.

**5. Units**

Internally, one unit of cash (`Q`) is one USDC atom times 10¹⁸. One lot is 0.001 of a claim and pays exactly `1000·Q` if YES wins, so a fill at tick `t` moves exactly `lots · t · Q`. Deposits and withdrawals still happen in normal 6-decimal USDC. Leftover fractions are never rounded up into money you can withdraw.

**6. What an order is made of**

- **tick**: 1 to 999, and the price is tick / 1000
- **lots**: size in thousandths of a claim, up to 2⁴⁰ lots per position
- **epochs**: version numbers on the market and the account, so an old order can never free up margin that belongs to a newer one

## Contract Addresses

Monad testnet (chain ID 10143), deployed 11 October 2026. Each market gets one engine contract that holds both its order book and its risk engine, so there's no separate address for the book.

- **Market engine (order book + risk), "Will Democrats win white women in the midterms?"**: [`0xA3955B47E943CCC6A23E3A66CFd60068de518068`](https://testnet.monadscan.com/address/0xA3955B47E943CCC6A23E3A66CFd60068de518068)
- **ReserveVault (for that market)**: [`0x2B52E9796d86c04465c9a7d673f5060d280586e2`](https://testnet.monadscan.com/address/0x2B52E9796d86c04465c9a7d673f5060d280586e2)
- **CollateralVault**: [`0x5E53c88eB3dA4C8640BC7AF51F0C5f8CC11205e4`](https://testnet.monadscan.com/address/0x5E53c88eB3dA4C8640BC7AF51F0C5f8CC11205e4)
- **MarketFactory**: [`0x33Bf4bba245253377f2875C77a6647a76ef42600`](https://testnet.monadscan.com/address/0x33Bf4bba245253377f2875C77a6647a76ef42600)
- **MarketRegistry**: [`0x780E73dDc65113F8C9C506daa25A0404Ed9f3E33`](https://testnet.monadscan.com/address/0x780E73dDc65113F8C9C506daa25A0404Ed9f3E33)
- **EngineCodeStore**: [`0x009d425581A3cD59f78BB5198C52b2452bD93491`](https://testnet.monadscan.com/address/0x009d425581A3cD59f78BB5198C52b2452bD93491)
- **EngineCodeStoreTail**: [`0x4231E897b07F6b6728569663Dfa73C88cc8FB0C7`](https://testnet.monadscan.com/address/0x4231E897b07F6b6728569663Dfa73C88cc8FB0C7)
- **KeeperRouter**: [`0xf9afbf482F428f26E7a093Cd9B790827c9bE5667`](https://testnet.monadscan.com/address/0xf9afbf482F428f26E7a093Cd9B790827c9bE5667)
- **RolloverBatcher**: [`0x59B40464F76BBA6009116d427ADD7f85cC295436`](https://testnet.monadscan.com/address/0x59B40464F76BBA6009116d427ADD7f85cC295436)
- **ResolutionOracle**: [`0xb86a48B07eE07037F1B52273B9B50f20615B61e4`](https://testnet.monadscan.com/address/0xb86a48B07eE07037F1B52273B9B50f20615B61e4)
- **UmaAdapter**: [`0x2750c61Ae27A40875b10D8232f68f31a8e2a3385`](https://testnet.monadscan.com/address/0x2750c61Ae27A40875b10D8232f68f31a8e2a3385)
- **TestUSDC**: [`0x82C7236A14B635AFB6dC825115570aFE4C23c1DB`](https://testnet.monadscan.com/address/0x82C7236A14B635AFB6dC825115570aFE4C23c1DB)

These run on test USDC with made-up risk calibration, and resolution goes through a testnet oracle sandbox. Nothing here is production collateral.

## Architecture & User Flow

![Eros Markets architecture: external price publication, on-chain execution and risk, collateral, resolution, and indexing](docs/assets/architecture/01-system.svg)

| Layer | What it does |
| --- | --- |
| Contracts | Match orders, check margin, track collateral, liquidate and settle |
| Price publisher | Pulls prices from Polymarket, sanity-checks them and publishes signed prices |
| Resolution services | Keep the market registry and decide outcomes |
| Market operators | Keep prices flowing, sample the book, push accounting forward and quote liquidity |
| SDKs and indexer | Contract interfaces, read models and event history |
| Trading app | Browse markets, connect a wallet, trade and check your account |

Here's what happens over one market's life, from depositing to claiming your payout:

<img src="docs/assets/architecture.png" width="800" alt="EventPerp call sequence" />

## 🚀 Quick Start

### Prerequisites

- Foundry 1.8.3
- Python 3 (for the reference engine, standard library only)
- Node.js 22.x (for the frontend)
- Git

### Contracts

```bash
# Clone the repository
git clone --recursive https://github.com/akronim26/eros-markets.git
cd eros-markets/contracts

# Build, and check contract sizes against Monad's 128 KiB limit
forge build --sizes

# Run the tests
forge test
```

### Longer test runs

```bash
# What CI runs: 10k fuzz runs and bigger invariant runs (takes about 6–8 minutes)
FOUNDRY_PROFILE=ci forge test

# Fails if gas usage changed
FORGE_SNAPSHOT_CHECK=true forge test --mc BookGasTest

# Check one task against the exact Python reference (run from the repo root).
# Heads up: this rewrites that task's evidence file in artifacts/tasks/.
bash scripts/check-task.sh A010
```

### Frontend

```bash
git clone --branch feat/pricefeed --recurse-submodules https://github.com/akronim26/eros-markets.git
cd eros-markets
npm ci --prefix frontend
cp frontend/.env.example frontend/.env.local
npm run dev --prefix frontend
```

Then open the URL Next.js prints, usually `http://localhost:3000`. The app talks to our Monad testnet deployment. To log in with a wallet, set `NEXT_PUBLIC_PRIVY_APP_ID` in `frontend/.env.local` and allow your local URL in Privy. Without it you can still browse, you just can't sign anything. Keep RPC URLs that contain keys in the server-only `MONAD_RPC_URL`.

The frontend on its own won't start the price publishers, makers, keepers or indexer, and without them there's no market data.

### Development Team

- [@0xr10t](https://github.com/0xr10t)
- [@akronim26](https://github.com/akronim26)
- [@YASH-ai-bit](https://github.com/YASH-ai-bit)
- [@xipharis](https://github.com/xipharis)
- [@Okheer](https://github.com/Okheer)

*Built with ❤️ by Eros Markets*
