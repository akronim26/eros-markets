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
  <a href="#-quick-start">Quick start</a> &middot;
  <a href="#documentation">Documentation</a>
</p>

## Introduction

> **Leverage on prediction markets sounds simple until the market resolves. Then the price jumps to 0 or 1 in one block, and someone has to pay for it.**

Eros Markets lets you trade real-world events with leverage on Monad. You go long or short on an event's YES price through an on-chain order book, and when the event resolves, your position settles against what actually happened.

Here's the problem we kept running into. A YES token pays 1 USDC if the event happens and nothing if it doesn't, so its price is basically the market's probability. Trading that with leverage works fine while the question is still open. But at resolution the price doesn't drift to 0 or 1, it jumps there in a single block. No liquidator can get in front of that, and a leveraged trader on the wrong side simply can't cover the loss.

So we built EventPerp around two rules. First, leverage has to come down to 1x before the jump. Second, whatever losses are still left have to be covered by a reserve that's funded up front. The order book, the margin engine, the reserve and the payouts all live on-chain.

We use **Polymarket as an outside price reference**. Trades don't go to Polymarket and we don't borrow its liquidity. Orders match on Eros, against Eros makers, backed by Eros collateral and reserves. Polymarket just helps us tell what a fair price looks like.

## Key Features

- **The order book is fully on-chain**: 999 price ticks from 0.001 to 0.999, a small bitmap to find the best price fast, first-in-first-out queues at each price, and a hard cap on how much work one match can do. You get limit, IOC and post-only orders, reduce-only, expiry by block, and a cancel-all that costs the same however many orders you have.
- **Long or short, up to 5×**: that's the ceiling a market can be listed with. How much you can actually open depends on the price, the calibration, your collateral, the reserve and how close the market is to resolving.
- **The reserve covers both outcomes**: at every step we check that the reserve could pay out whether the event ends YES or NO. If both ends are covered, every INVALID price in between is covered too.
- **Margin that knows about the deadline**: margin grows as resolution gets closer and as the chance of a sudden jump goes up. Everything rounds against the trader. If the risk parameters are missing or out of date, the market falls back to 1x instead of guessing.
- **Leverage winds down on a fixed schedule**: 12.5 hours before the scheduled end, new positions must be fully backed. At 12 hours every account must be. In the last hour you can only reduce. Then trading stops. The full-backing check doesn't need a price, so it still works if the price feed goes quiet.
- **Liquidation tries the gentle options first**: we first try to match two accounts that both need closing, then sell into the book. Only if an account's equity has hit zero do we move the whole thing into the reserve. Thin liquidity on its own is never a reason to take someone's account.
- **No rounding surprises**: cash is tracked in tiny exact units, so every fill adds up to the last atom. There's no floating point anywhere in the contracts or the reference code.
- **Settlement doesn't get stuck**: the oracle's halt and settle calls do a fixed amount of work. Payouts are prepared in small batches afterwards, and each trader claims exactly once.
- **A real trading app**: connect a wallet, watch markets, place and manage orders, and move collateral around. Built with Next.js, Privy and viem/wagmi.

## Mathematical Foundation

### The EventPerp Model

The engine follows the Risk & Clearing spec in [`docs/spec/risk_spec.md`](docs/spec/risk_spec.md) (v1.1, economic baseline v1.0). If you want the full derivations, they're in [`docs/eventperp-design.md`](docs/eventperp-design.md). Here's the short version.

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

## What We Changed from the Source Specs

### Core Protocol

1. We ship cash settlement first. Swapping positions for outcome tokens is built as a separate extension and is switched off for now (DEC-10).
2. Funding is designed around fixed hourly rates with a bounded catch-up sweep (DEC-02), but the current integration turns periodic funding payments and payout haircuts off.
3. Every maker gets re-checked on every fill, and resting orders lock up a cautious amount of margin up front (DEC-05).
4. When an account has to be closed out, its cash and its position move into the reserve together. We never pay off bad debt with cash, because only the whole-account move keeps both outcomes covered (DEC-13).
5. INVALID settles at the average index price over the last 24 hours before the scheduled end. If data is missing, there's a one-hour grace and then a fixed 0.5, and that's disclosed when the market lists (DEC-08).
6. Each market holds at most 1,024 traders in v1, so halting and checkpointing always finish in bounded time (DEC-12).

### Order Book

1. Each market gets its own book, so none of the risk hooks need a market id.
2. When a maker can't fill, the book gets a status code back instead of a revert, so one bad order doesn't kill the whole match.
3. An order slot that has been reused 255 times is retired, so an order id is never handed out twice.
4. The maximum number of fills per match is set per market from real gas measurements, not hardcoded.

The complete list is in [`contracts/README.md`](contracts/README.md#where-this-differs-from-the-spec), and the decisions DEC-01 to DEC-14 are in the spec.

## Current Status

**In development on Monad testnet, as of 11 October 2026.**

All of it lives on the [`feat/pricefeed`](https://github.com/akronim26/eros-markets/tree/feat/pricefeed) branch: the contracts, the price publisher, the resolution services, the SDKs, the indexer and the trading app. Our local tests take a leveraged trade all the way through settlement and payout. We've also created markets, funded reserves and started operators on Monad testnet. That doesn't mean a market is open for trading right now, though.

The latest fixes to how pricing starts up work locally but need a fresh deployment before existing testnet markets get them. There's also a known, documented gap in hourly MARK price availability. More detail in the [implementation status](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/README.md#implementation-status) and [startup findings](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/docs/integration/FAST_MARK_STARTUP.md).

To be clear about where this stands: it runs on test collateral with made-up risk calibration, it isn't production-ready, and nobody has audited it. A 5× listing ceiling doesn't mean you'll actually be able to open a 5× position.

## Contract Addresses

Everything is on Monad testnet (chain ID 10143). The order book and the risk engine are the same contract, `BookRiskEngine`, so there's no separate address for the book.

- **What's deployed from this branch**: [`addresses.md`](addresses.md)
- **The newest deployment records**: [`feat/pricefeed/addresses.md`](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/addresses.md)

These are test setups, not real collateral or a production oracle.

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

You can edit this diagram in Excalidraw: open [`docs/assets/architecture.excalidraw`](docs/assets/architecture.excalidraw) at [excalidraw.com](https://excalidraw.com). Or change the steps in `docs/assets/gen_architecture.py` and run `python3 docs/assets/gen_architecture.py` to rebuild it.

Where things live in the contracts:

| Module | Where | Looks after |
|---|---|---|
| Order book | `contracts/src/Book.sol` | order ids, price levels, matching, cancels |
| Risk & Clearing | `contracts/src/risk`, `contracts/src/math` | cash, positions, margin, funding, premiums, reserve coverage, liquidation, market stages |
| Pricing | `contracts/src/pricing` | signed price updates, the 5-minute index average, the mark price |
| Vaults | `contracts/src/vaults` | USDC custody (`CollateralVault`), reserve shares (`ReserveVault`), `BackstopPool` |
| Settlement | `contracts/src/settlement` | the halt snapshot, the INVALID price, preparing payouts, claims |
| Resolution oracle | another team | evidence, voting and disputes. It can only call `halt`, `settle` and `settleInvalid` |

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

The full app lives on [`feat/pricefeed`](https://github.com/akronim26/eros-markets/tree/feat/pricefeed):

```bash
git clone --branch feat/pricefeed --recurse-submodules https://github.com/akronim26/eros-markets.git
cd eros-markets
npm ci --prefix frontend
cp frontend/.env.example frontend/.env.local
npm run dev --prefix frontend
```

Then open the URL Next.js prints, usually `http://localhost:3000`. The app talks to our Monad testnet deployment. To log in with a wallet, set `NEXT_PUBLIC_PRIVY_APP_ID` in `frontend/.env.local` and allow your local URL in Privy. Without it you can still browse, you just can't sign anything. Keep RPC URLs that contain keys in the server-only `MONAD_RPC_URL`.

The frontend on its own won't start the price publishers, makers, keepers or indexer, and without them there's no market data. If you want a throwaway local backend with test collateral and a full settlement run, follow the [integrated backend setup](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/README.md#exercise-the-integrated-backend-locally).

### What the tests cover

1. `contracts/test/Book*.t.sol` tests the order book on its own: the bitmap, the queues, matching, batches, invariants, and a side-by-side check against a deliberately simple reference book.
2. `contracts/test/BookRiskEngine.t.sol` runs the real risk engine on the real book, including a worked 5x trade and a liquidation that closes through the book.
3. `contracts/test/math`, `contracts/test/risk` and `contracts/test/integration` hold the per-task tests. Their expected values come from the Python engine in `reference/`, which uses exact fractions and no floats.

## Documentation

### The spec

Everything here follows [`docs/spec/risk_spec.md`](docs/spec/risk_spec.md). How we talk to the order book and the oracle is in [`docs/spec/book_interface.md`](docs/spec/book_interface.md) and [`docs/spec/oracle_interface.md`](docs/spec/oracle_interface.md).

### Guides

| Guide | Read this to… |
| --- | --- |
| [Technical README](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/README.md) | dig into the implementation, setup and test commands |
| [Pricing and market readiness](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/README.md#pricing-and-market-readiness) | understand INDEX, MARK, warm-up and what has to be running |
| [Risk and collateral](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/docs/integration/LEVERAGE_INTEGRATION.md) | see how the reserve, calibration and leverage limits work |
| [Deployment records and addresses](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/addresses.md) | find the testnet contracts and who deployed what |
| [Local E2E testing](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/docs/integration/E2E_TESTING.md) | wire the backend and browser together and test a full market |
| [SDK and frontend interface](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/oracle/packages/oracle-sdk/FRONTEND_HANDOFF.md) | hook up contract reads, transactions and account states |

### A few ideas worth knowing

1. **Every action follows the same steps**: check who's calling, bring funding up to date, freeze one price for the whole transaction, update the accounts involved, then check margin and reserve coverage.
2. **The book and the risk engine talk directly**: the book calls the risk engine's internal hooks (`_riskPrepareTaker`, `_riskTryMatchedFill`, `_riskConvertPermitToRest`, `_riskOnUnrest`, `_riskFinishTaker`), so matching never makes an external call.
3. **New markets start fully backed**: until the book has enough history to compute a mark price, only fully backed orders can trade, priced off the outside index.
4. **Integration gates**: G0 to G7 are the checkpoints where everyone's work was merged and checked, listed in [`docs/spec/integration_gates.json`](docs/spec/integration_gates.json).

### Development Team

- [@0xr10t](https://github.com/0xr10t)
- [@akronim26](https://github.com/akronim26)
- [@YASH-ai-bit](https://github.com/YASH-ai-bit)
- [@xipharis](https://github.com/xipharis)

## 📄 License

The source files carry `SPDX-License-Identifier: MIT`.

*Built with ❤️ by Eros Markets*
