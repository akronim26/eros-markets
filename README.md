<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/akronim26/eros-markets/main/docs/assets/eros-mark-on-dark.svg">
    <img src="https://raw.githubusercontent.com/akronim26/eros-markets/main/docs/assets/eros-mark-on-light.svg" alt="Eros Markets logo" width="104" height="104">
  </picture>
</p>

<h1 align="center">Eros Markets</h1>

<p align="center">Long or short real-world event outcomes. Trade on Monad.</p>

<p align="center">
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#getting-started">Getting started</a> &middot;
  <a href="#documentation">Documentation</a>
</p>

## Introduction

Eros Markets is a protocol for leveraged binary event trading on Monad. Traders take long or short exposure to an event's YES outcome through an on-chain order book, with collateral accounting, market-specific risk controls, and cash settlement.

A long position gains from closing above its entry price; a short gains from closing below it, before fees and other applicable charges. Traders can close against available orders before the event ends or hold through resolution and settlement.

Eros uses **Polymarket as an external price reference**. Orders execute on Eros, backed by its own makers, collateral, and reserves. The external reference informs pricing and risk management; it does not route trades to Polymarket or import its liquidity.

## Key features

- **On-chain order book:** price-time priority, limit and immediate-or-cancel orders, post-only quotes, and reduce-only execution. Fills and their accounting updates happen atomically.
- **Long and short exposure:** reserve-backed leverage with a configured listing ceiling of up to **5×**. Actual admission depends on prices, calibration, collateral, reserves, and the market's lifecycle stage.
- **Isolated market accounting:** traders allocate collateral to individual markets, each with its own position ledger and reserve coverage.
- **Separate trading and settlement prices:** authenticated external observations and funded Eros book depth inform the trading risk price; a separate resolution oracle determines the final outcome.
- **A trading terminal:** wallet connection, market data, order management, positions, and collateral controls built with Next.js, Privy, and viem/wagmi.

## How it works

1. **Fund an account.** Deposit collateral into the vault and allocate it to a market.
2. **Place an order.** Buy or sell through the Eros order book. Risk checks determine how much exposure the account can take.
3. **Manage the position.** Cancel resting orders or close against available liquidity. Closing, releasing allocated collateral, and withdrawing to a wallet are separate actions.
4. **Settle after resolution.** Once the outcome is final and settlement preparation completes, eligible owners claim their payouts. The protocol defines YES, NO, and INVALID settlement paths.

The engine distinguishes **INDEX**, the averaged external reference, from **MARK**, the price used for risk calculations. MARK also incorporates eligible Eros book observations and pricing bounds. A fresh external price alone is insufficient: publishers, keepers, and funded makers must maintain the market together.

Margin controls individual exposure, while prefunded reserves cover admitted potential trader deficits under either terminal outcome. As scheduled resolution approaches, markets require full backing and later become reduce-only before trading halts.

## Architecture

![Eros Markets architecture: external price publication, on-chain execution and risk, collateral, resolution, and indexing](docs/assets/architecture/01-system.svg)

| Layer | Role |
| --- | --- |
| Contracts | Order matching, margin checks, collateral accounting, liquidation, and settlement |
| Price publisher | Collects Polymarket observations, validates source data, and publishes signed prices |
| Resolution services | Market registry, outcome resolution, and adjudication |
| Market operators | Maintain price publication, book sampling, accounting progress, and funded quotes |
| SDKs and indexer | Contract interfaces, read models, and event history |
| Trading application | Market discovery, wallet transactions, orders, and account views |

## Current status

**Development / Monad testnet — status as of 11 October 2026.**

The published integration branch contains the contracts, publisher, resolution services, SDKs, indexer, and trading application. Recorded local tests exercise leveraged trading through settlement and payout checks. Monad testnet deployment records include market creation, reserve funding, and operator startup; those records do not establish that markets are currently available for trading.

The latest pricing startup improvements have been validated locally and require a replacement deployment to reach existing testnet markets. An hourly MARK-availability gap remains documented. See the [implementation status](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/README.md#implementation-status) and [startup findings](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/docs/integration/FAST_MARK_STARTUP.md) for details.

The implementation uses test collateral and synthetic risk calibration. The selected integration disables periodic funding payments and payout haircuts. It is not production-ready or independently security-audited; the 5× listing ceiling does not guarantee executable 5× positions.

## Getting started

Active integration work and the complete application live on [`feat/pricefeed`](https://github.com/akronim26/eros-markets/tree/feat/pricefeed).

To run the frontend, install **Git and Node.js 22.x**, then:

```bash
git clone --branch feat/pricefeed --recurse-submodules https://github.com/akronim26/eros-markets.git
cd eros-markets
npm ci --prefix frontend
cp frontend/.env.example frontend/.env.local
npm run dev --prefix frontend
```

Open the URL printed by Next.js, normally `http://localhost:3000`. These commands assume a fresh clone and a Bash-compatible shell.

The frontend uses the configured Monad testnet deployment. Set `NEXT_PUBLIC_PRIVY_APP_ID` in `frontend/.env.local` and allow your local origin in Privy to enable wallet login. Without an app ID, the application supports public reads with wallet actions disabled. Credential-bearing RPC URLs belong in server-only `MONAD_RPC_URL`.

Starting the frontend does not start publishers, makers, keepers, or the indexer. Market data and trading availability depend on those services. For a disposable local backend with test collateral and a complete settlement scenario, follow the [integrated backend setup](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/README.md#exercise-the-integrated-backend-locally), which lists the additional Foundry, Bun, and Python requirements.

## Documentation

| Guide | Start here to… |
| --- | --- |
| [Technical README](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/README.md) | Explore implementation details, prerequisites, and validation commands |
| [Pricing and market readiness](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/README.md#pricing-and-market-readiness) | Understand INDEX, MARK, warm-up, and operating requirements |
| [Risk and collateral](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/docs/integration/LEVERAGE_INTEGRATION.md) | Understand reserve policy, calibration, and leverage constraints |
| [Deployment records and addresses](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/addresses.md) | Locate recorded testnet contracts and deployment identities |
| [Local E2E testing](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/docs/integration/E2E_TESTING.md) | Connect backend and browser fixtures for lifecycle testing |
| [SDK and frontend interface](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/oracle/packages/oracle-sdk/FRONTEND_HANDOFF.md) | Integrate contract reads, transaction flows, and account states |
